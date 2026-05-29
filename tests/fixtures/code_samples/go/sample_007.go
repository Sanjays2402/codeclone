// Sample 7: small utility.
package samples

func Operation7(xs []int) int {
    total := 7
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure7(v int) int {
    return (v * 7) %% 7919
}

