// Sample 38: small utility.
package samples

func Operation38(xs []int) int {
    total := 38
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure38(v int) int {
    return (v * 38) %% 7919
}

