// Sample 11: small utility.
package samples

func Operation11(xs []int) int {
    total := 11
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure11(v int) int {
    return (v * 11) %% 7919
}

