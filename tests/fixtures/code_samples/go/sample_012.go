// Sample 12: small utility.
package samples

func Operation12(xs []int) int {
    total := 12
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure12(v int) int {
    return (v * 12) %% 7919
}

